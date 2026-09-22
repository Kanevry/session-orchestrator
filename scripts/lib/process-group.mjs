/**
 * process-group.mjs — process-GROUP spawn/kill, identity re-verification and the
 * gate-process ledger (Epic #1425: A4, plus the primitives A1/A2 and B3 build on).
 *
 * Why a group and not a child: `spawn(cmd, { shell: true })` makes the SHELL the
 * child. `child.kill()` signals that shell only, and its own children —
 * `tsgo --noEmit`, vitest workers — are reparented to PID 1 and keep running.
 * That is the 2026-09-20 incident: four orphaned `tsgo` processes, two at
 * PPID 1, up to 8.0 GB RSS each, host at 13% free memory. `detached: true`
 * makes the shell a process-group LEADER (`child.pid === pgid`, setsid), so
 * `process.kill(-pgid, sig)` reaches every descendant that did not setsid away.
 *
 * Measured on this host (Darwin 25.6.0, 2026-09-21) and load-bearing here:
 *  - `process.kill(-pgid, 'SIGTERM')` does NOT terminate a grandchild that
 *    installs `trap "" TERM`; SIGKILL to the group does. Hence the ladder.
 *  - `close` fires only once EVERY group member has closed the shared pipe, so
 *    a surviving grandchild hangs the promise. Hence the hard deadline.
 *  - `maxBuffer` does not exist on async `spawn` (22 MB ran through unbounded).
 *    Hence the hand-rolled byte cap, which reproduces the spawnSync/ENOBUFS
 *    contract the existing gate tests pin ("21 MiB → exitCode 1").
 *  - A detached child SURVIVES its parent's exit with PPID 1 unless someone
 *    kills the group. Hence {@link installExitHandler}.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { DEFAULT_KILL_GRACE_MS } from './wave-executor/dispatch-common.mjs';

/**
 * Re-exported, never re-defined: the SIGTERM→SIGKILL grace is a repo
 * convention with its own named ceiling in `dispatch-common.mjs`. A second
 * literal here would drift from it silently.
 */
export { DEFAULT_KILL_GRACE_MS };

/** Append-only ledger of every gate process THIS repo's orchestrator started.
 * Gitignored via `.gitignore:125` (`.orchestrator/runtime/`), verified with
 * `git check-ignore --no-index -v`. */
export const GATE_PROCESS_LEDGER_RELPATH = '.orchestrator/runtime/gate-processes.jsonl';

/**
 * How long to wait after SIGKILL before reading liveness back.
 *
 * Named ceiling (BV-004): 500 ms. On 2026-09-20 the hand-run cleanup routine
 * measured immediately after `kill -9` and reported "still alive" for processes
 * that were already gone — a signal is asynchronous, the reap is not instant.
 * Revisit if a survivor is ever observed clearing later than this; raising it
 * costs only the timeout path.
 */
export const DEFAULT_VERIFY_WAIT_MS = 500;

/** Byte cap on captured stdout+stderr. Mirrors the 16 MiB `maxBuffer` the
 * synchronous gate used, because async `spawn` has no `maxBuffer` at all. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Ledger entries older than this are not candidates for anything. */
export const DEFAULT_LEDGER_MAX_AGE_MS = 24 * 3600 * 1000;

/** Wall-clock ceiling for one gate command. Same 15 min as the synchronous
 * path's `GATE_TIMEOUT_MS`, per the PRD parameter table (`gate.timeout-path-b-ms`),
 * so both gate paths are allowed exactly as long. */
export const DEFAULT_GATE_TIMEOUT_MS = 900_000;

/** Lines of the tail returned as `output` (the full capture is `fullOutput`). */
const OUTPUT_TAIL_LINES = 50;

/** Signals whose default disposition terminates the process; on these the exit
 * handler must kill our groups before we go away. */
const EXIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * @typedef {object} GateProcessRecord
 * @property {number} pid           PID of the group leader (the shell).
 * @property {number} pgid          Process-group id — equals `pid` under `detached: true`.
 * @property {number} startTime     `Date.now()` at spawn. The identity anchor against PID recycling.
 * @property {string} commandSignature  Stable short form of the command — see {@link buildCommandSignature}.
 * @property {string|null} sessionId    Owning session, or null when unknown.
 * @property {string} recordedAt    ISO-8601 of `startTime`.
 */

/**
 * Groups this process started and has not yet reaped: pgid → its `killFn`.
 * Keyed by pgid so a double-register is idempotent. The stored `killFn` is the
 * one the caller passed, which is why the exit handler never reaches
 * `process.kill` for a group a test spawned through an injected seam.
 *
 * @type {Map<number, {killFn: (target: number, signal: string) => unknown}>}
 */
const LIVE_GROUPS = new Map();

let exitHandlerInstalled = false;

/**
 * Default liveness probe: signal 0 tells us whether a PID exists without
 * touching it. `ESRCH` = gone. `EPERM` = alive but not ours — reported as ALIVE
 * on purpose, because "I may not signal it" is not "it is dead", and a survivor
 * misreported as dead is exactly the false green this module exists to prevent.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** @param {number} ms @returns {Promise<void>} */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** @param {number} target @param {string} signal @returns {unknown} */
function defaultKill(target, signal) {
  return process.kill(target, signal);
}

/**
 * Is `pgid` a value that may be NEGATED and handed to `kill(2)`?
 *
 * The only guard between a malformed ledger line and a POSIX broadcast. Three
 * values are catastrophic rather than merely wrong, and all three are ordinary
 * JSON numbers that reach here from a file on disk:
 *  - `1` → `kill(-1, sig)` signals EVERY process the user may signal.
 *  - `0` / `-0` → `kill(-0, sig)` signals the CALLER's own group (the session).
 *  - a negative pgid → the negation turns it POSITIVE, so the group-wide kill
 *    silently degrades into a single-PID kill of a stranger.
 * `1` is excluded and not merely `<= 0` because pgid 1 is launchd's group on
 * Darwin and init's on Linux — a real id, and never one of ours.
 *
 * @param {unknown} pgid
 * @returns {boolean}
 */
function isSignalablePgid(pgid) {
  return Number.isInteger(pgid) && /** @type {number} */ (pgid) > 1;
}

/**
 * Is a parsed ledger line a usable {@link GateProcessRecord}?
 *
 * Shared by {@link readGateProcessLedger} and {@link pruneGateProcessLedger} so
 * the reader and the pruner cannot disagree about what "usable" means — a line
 * the reader rejects but the pruner keeps would sit in the ledger forever.
 *
 * `typeof === 'number'` is not enough for a value that gets NEGATED and handed
 * to `kill(2)`: `1`, `0`, `-0`, `NaN` and a negative pgid are all numbers, and
 * the first two are a POSIX broadcast and a self-kill respectively
 * ({@link isSignalablePgid}). `commandSignature` is required for the same class
 * of reason: without it the reaper's identity check has nothing to compare a
 * `ps` row against but the row itself.
 *
 * @param {unknown} parsed
 * @returns {boolean}
 */
function isValidLedgerRecord(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  const r = /** @type {Record<string, unknown>} */ (parsed);
  return isSignalablePgid(r.pid)
    && isSignalablePgid(r.pgid)
    && typeof r.commandSignature === 'string' && r.commandSignature.length > 0
    && typeof r.startTime === 'number' && Number.isFinite(r.startTime);
}

/**
 * Stable, short, non-reversible signature of a command line.
 *
 * Shape: `<first token>:<16 hex of sha256(full command)>`. The leading token
 * stays readable so a `ps` row can be matched against it by name
 * ({@link verifyProcessIdentity}); the hash discriminates two invocations of the
 * same binary with different arguments without copying a command line — which
 * may carry paths or tokens — into a ledger.
 *
 * @param {string} cmd  Full command line.
 * @returns {string} e.g. `npm:6f1c4e0a9b2d7e35`. Empty input yields `:<hash of "">`.
 */
export function buildCommandSignature(cmd) {
  const full = String(cmd ?? '');
  const firstToken = full.trim().split(/\s+/)[0] ?? '';
  const hash = createHash('sha256').update(full, 'utf8').digest('hex').slice(0, 16);
  return `${firstToken}:${hash}`;
}

/**
 * The command-name half of a signature (everything before the final `:`).
 *
 * @param {string} signature
 * @returns {string}
 */
function signatureToken(signature) {
  const s = String(signature ?? '');
  const i = s.lastIndexOf(':');
  return i === -1 ? s : s.slice(0, i);
}

/**
 * Install the process-wide exit handler that kills every still-registered group
 * with SIGKILL. Idempotent — repeated calls install nothing further.
 *
 * `detached: true` buys a process group at the price of survival: measured
 * 2026-09-21, a detached child outlives its parent's exit with PPID 1. This
 * handler is what pays that price back.
 *
 * On `exit` the cleanup is synchronous (no async work is possible there).
 * On a terminating SIGNAL the cleanup runs, and the signal's default effect is
 * restored ONLY when this handler is the sole listener for it — named ceiling
 * (BV-004): with another listener present we clean up and leave the exit
 * decision to it, rather than exiting out from under it. Revisit if a host ever
 * needs us to terminate despite a foreign listener.
 *
 * @returns {void}
 */
export function installExitHandler() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;

  process.once('exit', () => {
    killAllLiveGroupsSync();
  });

  for (const signal of EXIT_SIGNALS) {
    const handler = () => {
      killAllLiveGroupsSync();
      if (process.listenerCount(signal) === 0) {
        // We were the only listener: restore the default disposition so the
        // process still dies from the signal it was sent.
        process.kill(process.pid, signal);
      }
    };
    process.once(signal, handler);
  }
}

/**
 * SIGKILL every registered group, synchronously, swallowing every error.
 * Deliberately not exported: it is the exit path, not part of the interface.
 *
 * @returns {void}
 */
function killAllLiveGroupsSync() {
  for (const [pgid, entry] of LIVE_GROUPS) {
    if (!isSignalablePgid(pgid)) continue;
    try {
      entry.killFn(-pgid, 'SIGKILL');
    } catch {
      /* already gone, or not ours — nothing to do at exit time */
    }
  }
  LIVE_GROUPS.clear();
}

/**
 * Send SIGTERM → grace → SIGKILL to a whole process GROUP, then VERIFY.
 *
 * The verification is the point: `ok` is true only when nothing answers a
 * liveness probe after `verifyWaitMs`. An exit code or a sent signal proves
 * nothing (PRD B6), and a process that survives SIGKILL — e.g. one that
 * `setsid`-ed out of the group — is reported as a survivor, never booked as
 * success.
 *
 * Error semantics:
 *  - `invalid-pgid` — the id is not a signalable process group
 *    ({@link isSignalablePgid}). Checked FIRST, before `beforeSignal` and before
 *    any signal: `ok: false`, `signalsSent: []`, nothing is sent. The ledger is
 *    a file on disk, and `pgid: 1` in one line means `kill(-1, …)` — a POSIX
 *    broadcast to every process this user may signal.
 *  - `ESRCH` on the FIRST signal — the group was already gone. `ok: true`,
 *    `error: 'ESRCH'`, no escalation.
 *  - `ESRCH` on the escalation — proof of death, not a failure: `error` stays
 *    null and the ladder completes normally.
 *  - `EPERM` — a foreign process sits in the group and refused our signal. Stop
 *    signal, never a retry: `ok: false`, `error: 'EPERM'`, `survivors: [pgid]`.
 *
 * ## `beforeSignal` — the ladder is ABORTABLE, and that is load-bearing
 *
 * The ladder sleeps `killGraceMs` (10 s by default) between the two signals, and
 * a promise cannot be un-awaited. Without a gate consulted IMMEDIATELY BEFORE
 * each signal, the escalation fires ~10 s after the caller has moved on — at a
 * pgid the caller has already deregistered and the kernel may have recycled onto
 * a stranger. Two callers need exactly that gate, for the same reason:
 *  - {@link spawnInGroup} passes `() => !settled`, so a child that closed during
 *    the grace window never draws a late group-wide SIGKILL.
 *  - the orphan-reaper passes a fresh identity re-check (PRD B3), so a PID
 *    recycled between SIGTERM and SIGKILL is never escalated against.
 *
 * It may be async; a throw counts as REFUSAL (fail-closed — an unmeasurable gate
 * must never read as permission). An abort returns `aborted: '<signal>'`,
 * `ok: false`, and `signalsSent` carries only the signals actually attempted.
 *
 * @param {number} pgid  Process-group id (positive; the negation happens here).
 * @param {object} [opts]
 * @param {(target: number, signal: string) => unknown} [opts.killFn]  Signal seam. Tests ALWAYS inject.
 * @param {number} [opts.killGraceMs]
 * @param {number} [opts.verifyWaitMs]
 * @param {(pid: number) => boolean} [opts.isAliveFn]  Liveness probe on the group leader.
 * @param {(ms: number) => Promise<void>} [opts.sleepFn]
 * @param {((signal: string) => boolean|Promise<boolean>)|null} [opts.beforeSignal]  Consulted
 *   immediately before EVERY signal. Anything but `true` aborts the rest of the ladder.
 * @returns {Promise<{ok: boolean, signalsSent: string[], survivors: number[],
 *   error: 'ESRCH'|'EPERM'|'invalid-pgid'|null, aborted: string|null}>}
 *   `signalsSent` records ATTEMPTS in order, including one that threw.
 */
export async function killProcessGroup(pgid, {
  killFn = defaultKill,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  verifyWaitMs = DEFAULT_VERIFY_WAIT_MS,
  isAliveFn = defaultIsAlive,
  sleepFn = defaultSleep,
  beforeSignal = null,
} = {}) {
  /** @type {string[]} */
  const signalsSent = [];

  // Fail-closed BEFORE anything else: an unsignalable id never reaches `killFn`,
  // not even through an injected seam, and `beforeSignal` is not consulted —
  // there is nothing to permit.
  if (!isSignalablePgid(pgid)) {
    return {
      ok: false, signalsSent, survivors: [], error: 'invalid-pgid', aborted: null,
    };
  }

  /** Fail-closed gate: only an explicit `true` permits the signal. */
  const permitted = async (signal) => {
    if (typeof beforeSignal !== 'function') return true;
    try {
      return (await beforeSignal(signal)) === true;
    } catch {
      return false;
    }
  };
  const aborted = (signal) => ({
    ok: false, signalsSent, survivors: [], error: null, aborted: signal,
  });

  if (!(await permitted('SIGTERM'))) return aborted('SIGTERM');

  signalsSent.push('SIGTERM');
  try {
    killFn(-pgid, 'SIGTERM');
  } catch (err) {
    const code = err?.code ?? null;
    if (code === 'ESRCH') {
      return { ok: true, signalsSent, survivors: [], error: 'ESRCH', aborted: null };
    }
    return {
      ok: false, signalsSent, survivors: [pgid], error: code === 'EPERM' ? 'EPERM' : null, aborted: null,
    };
  }

  await sleepFn(killGraceMs);

  // Escalate unconditionally: SIGTERM is a REQUEST and a grandchild with a
  // TERM trap ignores it (measured). SIGKILL on an already-dead group throws
  // ESRCH, which is the cheapest possible proof that the ladder worked.
  // "Unconditionally" means "regardless of what SIGTERM appeared to achieve" —
  // never "regardless of whether this pgid is still the process we targeted",
  // which is what `beforeSignal` re-decides here.
  if (!(await permitted('SIGKILL'))) return aborted('SIGKILL');

  signalsSent.push('SIGKILL');
  let escalationEsrch = false;
  try {
    killFn(-pgid, 'SIGKILL');
  } catch (err) {
    const code = err?.code ?? null;
    if (code === 'ESRCH') {
      escalationEsrch = true;
    } else {
      return {
        ok: false, signalsSent, survivors: [pgid], error: code === 'EPERM' ? 'EPERM' : null, aborted: null,
      };
    }
  }

  if (escalationEsrch) {
    return { ok: true, signalsSent, survivors: [], error: null, aborted: null };
  }

  await sleepFn(verifyWaitMs);
  const alive = isAliveFn(pgid) === true;
  return {
    ok: !alive,
    signalsSent,
    survivors: alive ? [pgid] : [],
    error: null,
    aborted: null,
  };
}

/**
 * Re-verify, immediately before signalling, that PID `pid` is still the process
 * the ledger recorded — the guard against PID recycling (PRD B3, Feature Area 3).
 *
 * PURE: `snapshotLine` is an ALREADY-PARSED `ps` row, so this function does no
 * I/O and is fully testable from text fixtures. `null` means the process is gone.
 *
 * Both checks must hold:
 *  1. Start time. macOS has no `etimes` and its `lstart` is locale-dependent, so
 *     the comparison runs over ELAPSED seconds: `nowMs - etimeSeconds*1000`
 *     against the recorded `startTime`, within `toleranceMs`.
 *  2. Command signature. The leading token of `expected.commandSignature` must
 *     prefix the observed `args` (an exact full-signature match also passes).
 *
 * Fail-closed: a row with no measurable `etimeSeconds` yields
 * `start-time-mismatch` with `observed.etimeSeconds === null`, so a caller can
 * tell "measured, and it differs" from "could not be measured" — both refuse
 * the signal, and only the second is an instrument gap.
 *
 * @param {number} pid
 * @param {{startTime: number, commandSignature: string}} expected
 * @param {object} [opts]
 * @param {{pid?: number, ppid?: number, rssKb?: number, etimeSeconds?: number|null, cpuPct?: number, args?: string|null}|null} [opts.snapshotLine]
 * @param {number} [opts.nowMs]
 * @param {number} [opts.toleranceMs=2000]
 * @returns {{match: boolean, reason: 'ok'|'gone'|'start-time-mismatch'|'signature-mismatch', observed: {etimeSeconds: number|null, args: string|null}}}
 */
export function verifyProcessIdentity(pid, expected, {
  snapshotLine = null,
  nowMs = Date.now(),
  toleranceMs = 2000,
} = {}) {
  const gone = { match: false, reason: /** @type {const} */ ('gone'), observed: { etimeSeconds: null, args: null } };
  if (!snapshotLine || typeof snapshotLine !== 'object') return gone;
  // A row for a different PID describes a different process, not this one.
  if (snapshotLine.pid !== undefined && snapshotLine.pid !== null
    && Number(snapshotLine.pid) !== Number(pid)) return gone;

  const etimeSeconds = typeof snapshotLine.etimeSeconds === 'number' && Number.isFinite(snapshotLine.etimeSeconds)
    ? snapshotLine.etimeSeconds
    : null;
  const args = typeof snapshotLine.args === 'string' ? snapshotLine.args : null;
  const observed = { etimeSeconds, args };

  if (etimeSeconds === null) {
    return { match: false, reason: 'start-time-mismatch', observed };
  }
  const observedStart = nowMs - etimeSeconds * 1000;
  if (Math.abs(observedStart - Number(expected?.startTime)) > toleranceMs) {
    return { match: false, reason: 'start-time-mismatch', observed };
  }

  const wanted = String(expected?.commandSignature ?? '');
  const token = signatureToken(wanted);
  const argsFirstToken = (args ?? '').trim().split(/\s+/)[0] ?? '';
  const signatureOk = args !== null
    && token.length > 0
    && (argsFirstToken === token || buildCommandSignature(args) === wanted);
  if (!signatureOk) {
    return { match: false, reason: 'signature-mismatch', observed };
  }

  return { match: true, reason: 'ok', observed };
}

/**
 * Absolute path of the gate-process ledger for a repo.
 * The relpath lives in exactly one constant so no second site spells
 * `.orchestrator` by hand.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
function ledgerPathFor(repoRoot) {
  return path.join(repoRoot, ...GATE_PROCESS_LEDGER_RELPATH.split('/'));
}

/**
 * Append one {@link GateProcessRecord} to the gate-process ledger.
 *
 * Append-only JSONL: concurrent gate runs from parallel sessions each add their
 * own line and never rewrite a foreign one. Best-effort — a ledger write must
 * never fail a gate — but a failure prints one WARN line to stderr rather than
 * vanishing (a ledger that silently stops being written is indistinguishable
 * from a host with no gate processes).
 *
 * @param {string} repoRoot
 * @param {GateProcessRecord} record
 * @param {object} [opts]
 * @param {(filePath: string, line: string) => void} [opts.appendFn]  Sink seam. When
 *   supplied, the parent directory is NOT created — the caller owns its sink, and
 *   mkdir on a synthetic repoRoot would materialise a directory in a test.
 * @returns {void}
 */
export function recordGateProcess(repoRoot, record, { appendFn } = {}) {
  const target = ledgerPathFor(repoRoot);
  try {
    if (!appendFn) mkdirSync(path.dirname(target), { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    if (appendFn) appendFn(target, line);
    else appendFileSync(target, line, 'utf8');
  } catch (err) {
    process.stderr.write(
      `process-group: could not record gate process in ${GATE_PROCESS_LEDGER_RELPATH}: ${err?.message ?? String(err)}\n`,
    );
  }
}

/**
 * Read the gate-process ledger, tolerantly.
 *
 * Malformed lines are skipped AND COUNTED: a silently skipping JSONL parser
 * turns a partial read into a clean verdict, which is the exact failure mode a
 * reaper must not have. "Malformed" includes a line whose `pid`/`pgid` is not a
 * SIGNALABLE process-group id and one carrying no `commandSignature` — see the
 * inline note at the check. Entries older than `maxAgeMs` are filtered out and
 * counted separately — they are not candidates for anything, and their PIDs are
 * the most likely to have been recycled.
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {(filePath: string) => string} [opts.readFn]  Reader seam; must throw or
 *   return '' for a missing file.
 * @param {number} [opts.nowMs]
 * @param {number} [opts.maxAgeMs]
 * @returns {{records: GateProcessRecord[], malformedLines: number, expired: number}}
 *   `records` are the fresh, parseable entries in source order.
 */
export function readGateProcessLedger(repoRoot, {
  readFn,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_LEDGER_MAX_AGE_MS,
} = {}) {
  const target = ledgerPathFor(repoRoot);
  let raw = '';
  try {
    if (readFn) raw = readFn(target) ?? '';
    else if (existsSync(target)) raw = readFileSync(target, 'utf8');
  } catch {
    return { records: [], malformedLines: 0, expired: 0 };
  }

  /** @type {GateProcessRecord[]} */
  const records = [];
  let malformedLines = 0;
  let expired = 0;

  for (const line of String(raw).split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (!isValidLedgerRecord(parsed)) {
      malformedLines += 1;
      continue;
    }
    if (nowMs - parsed.startTime > maxAgeMs) {
      expired += 1;
      continue;
    }
    records.push(parsed);
  }

  return { records, malformedLines, expired };
}

/**
 * Drop expired and unusable lines from the ledger, rewriting it in place.
 * "Unusable" is {@link isValidLedgerRecord}'s verdict — the same one
 * {@link readGateProcessLedger} applies, so nothing the reader skips survives
 * the pruner.
 *
 * Called once per gate command from {@link spawnInGroup}'s register path and
 * once per scan from the orphan reaper: an append-only ledger with no pruner
 * grows monotonically, and it had none until 2026-09-22.
 *
 * In-process fs only — never a shell `rm`/`mv` (PSA-003, and
 * `.orchestrator/metrics/**` deletions are a blocked-command rule for a reason).
 *
 * Named ceiling (BV-004): read-filter-write is not atomic against a concurrent
 * append, so a line appended between the read and the write is lost. Acceptable
 * while the ledger is one line per gate command (tens per session) and its only
 * consumer is a best-effort reaper. Revisit — with an exclusive lock or an
 * append-only compaction sidecar — if the ledger ever gains a consumer that
 * must not miss an entry.
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {number} [opts.nowMs]
 * @param {number} [opts.maxAgeMs]
 * @param {{existsSync: Function, readFileSync: Function, writeFileSync: Function}} [opts.fs]  fs seam.
 * @returns {number} Number of lines removed (expired + malformed). 0 when the
 *   ledger is absent, empty, or unreadable.
 */
export function pruneGateProcessLedger(repoRoot, {
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_LEDGER_MAX_AGE_MS,
  fs: fsSeam,
} = {}) {
  const io = fsSeam ?? { existsSync, readFileSync, writeFileSync };
  const target = ledgerPathFor(repoRoot);
  let raw;
  try {
    if (!io.existsSync(target)) return 0;
    raw = io.readFileSync(target, 'utf8');
  } catch {
    return 0;
  }

  const kept = [];
  let removed = 0;
  for (const line of String(raw).split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      removed += 1;
      continue;
    }
    if (!isValidLedgerRecord(parsed) || nowMs - parsed.startTime > maxAgeMs) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }

  if (removed === 0) return 0;
  try {
    io.writeFileSync(target, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
  } catch (err) {
    process.stderr.write(
      `process-group: could not prune ${GATE_PROCESS_LEDGER_RELPATH}: ${err?.message ?? String(err)}\n`,
    );
    return 0;
  }
  return removed;
}

/**
 * Spawn a command as the leader of its OWN process group and guarantee that the
 * whole group is gone when this promise settles.
 *
 * Timeout path: the group gets SIGTERM → `killGraceMs` → SIGKILL → verify
 * (`timedOut: true`, `exitCode: 124`).
 * Overflow path: the same ladder, triggered by the byte cap instead of the
 * clock (`overflow: true`, `exitCode: 1` — the contract the synchronous gate's
 * ENOBUFS behaviour already has).
 *
 * The promise resolves on `close` — which fires only when EVERY group member
 * has closed the shared pipe — or, if a member survives SIGKILL, on a hard
 * deadline of `killGraceMs + verifyWaitMs + 1000` measured from the start of the
 * kill ladder. Without that deadline one `setsid`-escaped grandchild hangs the
 * gate forever, which is the failure the whole module exists to prevent.
 *
 * The converse holds too: once this promise HAS settled, the ladder is
 * cancelled (`beforeSignal` in {@link killProcessGroup}). A cooperative child
 * that closes on SIGTERM would otherwise still draw a SIGKILL `killGraceMs`
 * later, at a pgid `finish()` already deregistered — the exact late signal at a
 * possibly-recycled group id this module exists to prevent.
 *
 * @param {string} cmd  Full shell command. Executable configuration, not data —
 *   see `.claude/rules/security.md` § Session Config Command Trust.
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number|null} [opts.timeoutMs]  null disables the clock (the byte cap still applies).
 * @param {number} [opts.killGraceMs]
 * @param {number} [opts.verifyWaitMs]
 * @param {number} [opts.maxOutputBytes]
 * @param {Function} [opts.spawnFn]  `(cmd, options) => ChildProcess`. Tests inject a fake.
 * @param {(target: number, signal: string) => unknown} [opts.killFn]  Tests ALWAYS inject.
 * @param {() => number} [opts.now]
 * @param {(pid: number) => boolean} [opts.isAliveFn]
 * @param {(ms: number) => Promise<void>} [opts.sleepFn]
 * @param {(record: GateProcessRecord) => void} [opts.onRegister]  Defaults to
 *   {@link recordGateProcess} when — and only when — `repoRoot` is given.
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.commandSignature]  Defaults to {@link buildCommandSignature}.
 * @param {string|null} [opts.sessionId]
 * @returns {Promise<{exitCode: number, output: string, fullOutput: string, timedOut: boolean,
 *   overflow: boolean, killSignals: string[], survivors: number[], pid: number, pgid: number,
 *   durationMs: number}>}
 *   `exitCode` is 124 on timeout, 1 on overflow or spawn failure, else the child's own code.
 *   `output` is the last ~50 lines of `fullOutput`. `survivors` are PIDs still alive after
 *   SIGKILL + `verifyWaitMs` — a non-empty list is a REPORTED failure, never a silent one.
 */
export function spawnInGroup(cmd, {
  cwd,
  env,
  timeoutMs = DEFAULT_GATE_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  verifyWaitMs = DEFAULT_VERIFY_WAIT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  spawnFn = spawn,
  killFn = defaultKill,
  now = Date.now,
  isAliveFn = defaultIsAlive,
  sleepFn = defaultSleep,
  onRegister,
  repoRoot,
  commandSignature,
  sessionId = null,
} = {}) {
  installExitHandler();

  return new Promise((resolve) => {
    const startedAt = now();
    /** @type {number|null} */
    let pid = null;
    /** @type {number|null} */
    let pgid = null;
    /** @type {string[]} */
    const killSignals = [];
    let fullOutput = '';
    let capturedBytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let ladderStarted = false;
    /** @type {number[]} */
    let survivors = [];
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timeoutTimer = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let deadlineTimer = null;

    const finish = (childExitCode) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (pgid !== null) LIVE_GROUPS.delete(pgid);
      let exitCode;
      if (timedOut) exitCode = 124;
      else if (overflow) exitCode = 1;
      else if (typeof childExitCode === 'number') exitCode = childExitCode;
      else exitCode = 1;
      resolve({
        exitCode,
        output: fullOutput.split('\n').slice(-OUTPUT_TAIL_LINES).join('\n').trim(),
        fullOutput,
        timedOut,
        overflow,
        killSignals,
        survivors,
        pid: pid ?? -1,
        pgid: pgid ?? -1,
        durationMs: now() - startedAt,
      });
    };

    let child;
    try {
      // The command is trusted configuration; `shell: true` is intentional.
      // `detached: true` is what makes this a GROUP leader — the whole point.
      // nosemgrep: unsafe-shell-spawn
      child = spawnFn(cmd, {
        cwd,
        env,
        shell: true,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      fullOutput = `process-group: failed to spawn "${cmd}": ${err?.message ?? String(err)}`;
      finish(1);
      return;
    }

    pid = typeof child?.pid === 'number' ? child.pid : null;
    // Under `detached: true` the child calls setsid, so it IS its own group
    // leader and pgid === pid (measured 2026-09-21, Darwin 25.6.0).
    pgid = pid;

    if (pgid !== null) {
      LIVE_GROUPS.set(pgid, { killFn });
      /** @type {GateProcessRecord} */
      const record = {
        pid,
        pgid,
        startTime: startedAt,
        commandSignature: commandSignature ?? buildCommandSignature(cmd),
        sessionId: sessionId ?? null,
        recordedAt: new Date(startedAt).toISOString(),
      };
      const register = onRegister ?? (repoRoot ? (r) => recordGateProcess(repoRoot, r) : null);
      if (register) {
        try {
          register(record);
        } catch {
          /* the ledger is an aid to the reaper, never a gate precondition */
        }
      }
      // Prune AFTER the append, once per gate command — the ledger is
      // append-only and had NO production pruner, so it grew monotonically
      // (measured 2026-09-22: 369 lines/day on this host). Only on the real
      // sink: with an injected `onRegister` the caller owns its storage and a
      // prune here would write a file the test never asked for. Cheap by
      // construction (the file holds one line per gate command) and wrapped,
      // because a pruner that throws must not fail the gate it is housekeeping
      // for.
      if (!onRegister && repoRoot) {
        try {
          pruneGateProcessLedger(repoRoot);
        } catch {
          /* housekeeping, never a gate precondition */
        }
      }
    }

    // Signals are recorded AT SEND TIME, not merged from the ladder's return
    // value: a cooperative child closes before `killProcessGroup` resolves, and
    // a `killSignals` filled after `resolve()` reports an empty ladder for the
    // very case the ladder worked.
    const trackingKill = (target, signal) => {
      killSignals.push(signal);
      return killFn(target, signal);
    };

    const runLadder = () => {
      if (ladderStarted || pgid === null) return;
      ladderStarted = true;
      // Hard deadline: `close` waits for EVERY group member to close the shared
      // pipe, so one survivor would hang this promise forever.
      deadlineTimer = setTimeout(() => {
        if (survivors.length === 0 && pgid !== null) survivors = [pgid];
        finish(null);
      }, killGraceMs + verifyWaitMs + 1000);
      deadlineTimer.unref?.();

      killProcessGroup(pgid, {
        killFn: trackingKill,
        killGraceMs,
        verifyWaitMs,
        isAliveFn,
        sleepFn,
        // Cancel the ladder the moment this promise settles. `finish()` has by
        // then deleted the pgid from LIVE_GROUPS, so a SIGKILL arriving
        // `killGraceMs` later would be aimed at an id nobody here owns any more
        // — and the kernel may have recycled it onto a foreign group.
        beforeSignal: () => !settled,
      })
        .then((res) => {
          survivors = res.survivors;
          if (!res.ok) finish(null);
        })
        .catch(() => {
          finish(null);
        });
    };

    const onChunk = (chunk) => {
      if (overflow) return;
      const text = chunk.toString();
      capturedBytes += Buffer.byteLength(text, 'utf8');
      fullOutput += text;
      if (capturedBytes > maxOutputBytes) {
        overflow = true;
        fullOutput += `\nprocess-group: output exceeded ${maxOutputBytes} bytes — killing process group.\n`;
        runLadder();
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        runLadder();
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    child.on('error', (err) => {
      fullOutput += `\nprocess-group: child error: ${err?.message ?? String(err)}`;
      finish(1);
    });
    child.on('close', (code) => finish(typeof code === 'number' ? code : null));
  });
}

/**
 * Test-only: the pgids this process currently has registered for exit-time
 * cleanup. Exported so a test can prove a group is deregistered after `close`
 * instead of asserting on module internals.
 *
 * @returns {number[]}
 */
export function _liveGroupPgids() {
  return [...LIVE_GROUPS.keys()];
}
