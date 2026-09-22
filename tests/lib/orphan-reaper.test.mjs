/**
 * orphan-reaper.test.mjs — Epic #1425 B1+B2.
 *
 * Every test names the bug it catches. The fixtures below are REAL `ps -Aww -o
 * pid=,ppid=,rss=,etime=,%cpu=,args=` lines captured on this host 2026-09-21
 * (Darwin 25.6.0) plus synthetic gate-process rows; no test ever uses a live
 * `ps` result as a kill target, and `killProcessGroup` is ALWAYS injected
 * (`.claude/rules/testing.md` — tests must not kill developer processes).
 *
 * Determinism comes from injected seams (`now`, `statFn`, `runPs`), not from
 * fake timers: nothing here reads a global clock, so freezing one would pin a
 * mechanism the code does not use.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import {
  FALSE_ALARM_SUSPECT_RATE,
  PS_ARGS,
  READ_ONLY_COMMAND_PATTERNS,
  REAPER_DEFAULTS,
  REAPER_SCAN_EVENT,
  auditPath,
  decideReapCandidates,
  falseAlarmRate,
  parsePsSnapshot,
  parsePsSnapshotDetailed,
  parseReaperCliArgs,
  psPidArgs,
  resolveDeps,
  runOrphanScan,
  scanMarkerPath,
  shouldScanNow,
  touchScanMarker,
} from '../../scripts/lib/orphan-reaper.mjs';
import {
  buildCommandSignature,
  killProcessGroup as realKillProcessGroup,
} from '../../scripts/lib/process-group.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Five REAL rows, captured 2026-09-21 on Darwin 25.6.0. Row 3 carries a SPACE
 *  inside `args` — the 16-character-`comm`-truncation trap Discovery d-2 named:
 *  68 of 784 processes had a space, so any parser that splits `args` on
 *  whitespace silently mangles them. */
const REAL_ROWS = [
  '    1     0  17472 09-11:05:54   0.8 /sbin/launchd',
  '  329     1  26112 09-11:04:32   1.3 /usr/libexec/logd',
  '  331     1   8672 09-11:04:32   0.0 /usr/libexec/UserEventAgent (System)',
  '  337     1   4352 09-11:04:32   0.0 /usr/sbin/systemstats --daemon',
  '  382     1   1120 09-11:09:37   0.0 /System/Library/PrivateFrameworks/Heimdal.framework/Helpers/kdc',
];

const makeOutput = (...rows) => [...rows].join('\n');

const NOW = 1_700_000_000_000;
/** `07:12` = 432 s — the 7-minute-old orphan from the acceptance criterion. */
const ORPHAN_AGE_S = 432;
const TSGO_ARGS = 'tsgo --noEmit';
const TSGO_SIG = buildCommandSignature(TSGO_ARGS);

/** One synthetic gate row. `etime` and the ledger `startTime` are kept
 *  consistent so the identity check passes for the right reason. */
const gateRow = ({ pid = 4242, ppid = 1, etime = '07:12', rss = 3_600_000, cpu = 97.2, args = TSGO_ARGS } = {}) =>
  `${String(pid).padStart(6)} ${String(ppid).padStart(5)} ${String(rss).padStart(6)} ${etime}   ${cpu} ${args}`;

const ledgerRecord = ({
  pid = 4242, pgid = 4242, ageSeconds = ORPHAN_AGE_S, signature = TSGO_SIG, sessionId = 'own-session',
} = {}) => ({
  pid,
  pgid,
  startTime: NOW - ageSeconds * 1000,
  commandSignature: signature,
  sessionId,
  recordedAt: new Date(NOW - ageSeconds * 1000).toISOString(),
});

// ---------------------------------------------------------------------------
// parsePsSnapshot
// ---------------------------------------------------------------------------

describe('parsePsSnapshot', () => {
  it('keeps args containing spaces intact — catches the whitespace-split bug that mangles the 68/784 processes whose command line has a space', () => {
    const rows = parsePsSnapshot(makeOutput(...REAL_ROWS));
    expect(rows).toHaveLength(5);
    const userEventAgent = rows.find((r) => r.pid === 331);
    expect(userEventAgent.args).toBe('/usr/libexec/UserEventAgent (System)');
    expect(userEventAgent.ppid).toBe(1);
    expect(userEventAgent.rssKb).toBe(8672);
    expect(userEventAgent.cpuPct).toBe(0);
  });

  it('parses DD-HH:MM:SS etime to whole seconds — catches an age computed from a format the twin parseEtimeToMinutes would round to minutes', () => {
    const [launchd] = parsePsSnapshot(makeOutput(REAL_ROWS[0]));
    // 09-11:05:54 = 9d + 11h + 5m + 54s
    expect(launchd.etimeSeconds).toBe(9 * 86400 + 11 * 3600 + 5 * 60 + 54);
  });

  it('counts unparseable lines instead of silently dropping them — a silently skipping parser turns a partial read into a clean verdict', () => {
    const detailed = parsePsSnapshotDetailed(makeOutput(
      REAL_ROWS[1],
      'this is not a ps row',
      '  999     1   1024 not-an-etime   0.0 /bin/sh',
      '',
    ));
    expect(detailed.rows).toHaveLength(1);
    expect(detailed.malformed).toBe(2);
  });

  it('returns an empty result for null input rather than throwing — the ps seam yields null on every failure', () => {
    expect(parsePsSnapshotDetailed(null)).toEqual({ rows: [], malformed: 0 });
    expect(parsePsSnapshot(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// decideReapCandidates — the pure decision
// ---------------------------------------------------------------------------

describe('decideReapCandidates', () => {
  it('returns the ledger-known, PPID-1, 7-minute-old read-only process as a candidate WITH its threshold and actual values, and sends no signal', () => {
    const snapshot = parsePsSnapshot(makeOutput(...REAL_ROWS, gateRow()));
    const killSpy = vi.fn();

    const out = decideReapCandidates(snapshot, [ledgerRecord()], NOW, {
      ownSessionId: 'own-session',
      livePeerSessionIds: [],
    });

    expect(out.candidates).toHaveLength(1);
    const [c] = out.candidates;
    expect(c).toMatchObject({
      pid: 4242,
      pgid: 4242,
      ppid: 1,
      ageSeconds: ORPHAN_AGE_S,
      rssKb: 3_600_000,
      cpuPct: 97.2,
      args: TSGO_ARGS,
      commandSignature: TSGO_SIG,
      trigger: 'orphan-ppid1',
      threshold: { minAgeSeconds: REAPER_DEFAULTS.minAgeSeconds },
      actual: { ageSeconds: ORPHAN_AGE_S },
      identity: { match: true, reason: 'ok' },
    });
    expect(c.ledgerRecord.pgid).toBe(4242);
    // The pure function owns no signal seam at all; this pins that no signal was
    // sent as a side effect of deciding.
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('rejects a PPID-1 system daemon that is not in the ledger with a traceable not-in-ledger reason — PPID 1 holds for 538 of 784 processes and is never sufficient on its own', () => {
    const snapshot = parsePsSnapshot(makeOutput(...REAL_ROWS));

    const out = decideReapCandidates(snapshot, [], NOW, { ownSessionId: 'own-session', livePeerSessionIds: [] });

    expect(out.candidates).toEqual([]);
    // launchd itself has ppid 0 and is not orphan-shaped; the other four are.
    expect(out.rejected).toHaveLength(4);
    const logd = out.rejected.find((r) => r.pid === 329);
    expect(logd).toEqual({ pid: 329, ppid: 1, ageSeconds: expect.any(Number), reason: 'not-in-ledger' });
    expect(out.rejected.every((r) => r.reason === 'not-in-ledger')).toBe(true);
  });

  it('reports a process owned by a foreign LIVE session instead of making it a candidate — PRD FA3: report, never auto-kill', () => {
    const snapshot = parsePsSnapshot(makeOutput(gateRow()));
    const records = [ledgerRecord({ sessionId: 'peer-session' })];

    const out = decideReapCandidates(snapshot, records, NOW, {
      ownSessionId: 'own-session',
      livePeerSessionIds: ['peer-session'],
    });

    expect(out.candidates).toEqual([]);
    expect(out.reported).toHaveLength(1);
    expect(out.reported[0]).toMatchObject({ pid: 4242, reason: 'foreign-live-session', sessionId: 'peer-session' });
  });

  it('reaps a foreign session that a SUCCESSFUL peer probe proved dead, but reports it when liveness was never measured — [] is a measurement, null is the absence of one', () => {
    const snapshot = parsePsSnapshot(makeOutput(gateRow()));
    const records = [ledgerRecord({ sessionId: 'crashed-session' })];

    const measured = decideReapCandidates(snapshot, records, NOW, {
      ownSessionId: 'own-session',
      livePeerSessionIds: [],
    });
    expect(measured.candidates).toHaveLength(1);

    const unmeasured = decideReapCandidates(snapshot, records, NOW, {
      ownSessionId: 'own-session',
      livePeerSessionIds: null,
    });
    expect(unmeasured.candidates).toEqual([]);
    expect(unmeasured.reported[0]).toMatchObject({ pid: 4242, reason: 'foreign-session-liveness-unknown' });
  });

  it('rejects a ledger process younger than min-age as too-young — the 2026-09-20 orphans were 7-17 min old, the threshold exists so a healthy 30 s gate run is never touched', () => {
    const snapshot = parsePsSnapshot(makeOutput(gateRow({ etime: '00:30' })));
    const records = [ledgerRecord({ ageSeconds: 30 })];

    const out = decideReapCandidates(snapshot, records, NOW, { ownSessionId: 'own-session', livePeerSessionIds: [] });

    expect(out.candidates).toEqual([]);
    expect(out.rejected[0]).toMatchObject({
      pid: 4242,
      reason: 'too-young',
      ageSeconds: 30,
      threshold: { minAgeSeconds: 300 },
    });
  });

  it('rejects a ledger process that still has a live parent as has-parent — Stufe 1 reaps orphans, not running gate commands', () => {
    const snapshot = parsePsSnapshot(makeOutput(gateRow({ ppid: 9001 })));

    const out = decideReapCandidates(snapshot, [ledgerRecord()], NOW, { ownSessionId: 'own-session', livePeerSessionIds: [] });

    expect(out.candidates).toEqual([]);
    expect(out.rejected[0]).toMatchObject({ pid: 4242, reason: 'has-parent', ppid: 9001 });
  });

  it('reports a non-read-only ledger process WITHOUT copying its command line — dev servers and MCP servers stay untouched and unquoted', () => {
    const args = 'node ./node_modules/.bin/next dev --port 3000';
    const snapshot = parsePsSnapshot(makeOutput(gateRow({ args })));
    const records = [ledgerRecord({ signature: buildCommandSignature(args) })];

    const out = decideReapCandidates(snapshot, records, NOW, { ownSessionId: 'own-session', livePeerSessionIds: [] });

    expect(out.candidates).toEqual([]);
    expect(out.reported[0]).toMatchObject({ pid: 4242, reason: 'not-read-only' });
    expect(out.reported[0].args).toBeUndefined();
  });

  it('rejects a recycled PID whose elapsed time contradicts the ledger start time — the PID-recycling guard, FA3', () => {
    // Same PID, but the process on it is 12 s old while the ledger says 432 s.
    const snapshot = parsePsSnapshot(makeOutput(gateRow({ etime: '10:00' })));
    const records = [ledgerRecord()];

    const out = decideReapCandidates(snapshot, records, NOW, { ownSessionId: 'own-session', livePeerSessionIds: [] });

    expect(out.candidates).toEqual([]);
    expect(out.rejected[0]).toMatchObject({ pid: 4242, reason: 'identity-mismatch' });
    expect(out.rejected[0].identity.reason).toBe('start-time-mismatch');
  });

  it('matches every read-only gate command the allowlist names and nothing else — a widened pattern that swallows a dev server would arm the reaper against it', () => {
    const accept = [
      'tsgo --noEmit',
      '/opt/homebrew/bin/tsgo --noEmit',
      'npx tsc --noEmit',
      'node /repo/node_modules/vitest/vitest.mjs run',
      'eslint .',
      'npm run lint',
      'npm test',
    ];
    const reject = [
      '/usr/libexec/logd',
      'node ./node_modules/.bin/next dev',
      'npm run build',
      'node mcp-server.mjs',
      '/sbin/launchd',
    ];
    const hits = (s) => READ_ONLY_COMMAND_PATTERNS.some((re) => re.test(s));
    expect(accept.filter(hits)).toEqual(accept);
    expect(reject.filter(hits)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runOrphanScan — orchestration
// ---------------------------------------------------------------------------

/**
 * Deps for `runOrphanScan`.
 *
 * `runPsPid` is ALWAYS injected — never left at its default — because the
 * default spawns a real `ps -p <pid>` against whatever process happens to own
 * 4242 on the developer's host. `psPidOutputs` is a queue read once per targeted
 * probe (before SIGTERM, before SIGKILL, after the ladder); the LAST entry
 * repeats, so a single-element queue means "the same row every time".
 */
const scanDeps = ({
  psOutputs, psPidOutputs, records = [ledgerRecord()], peers = [], kill, auditRecords,
} = {}) => {
  const queue = [...psOutputs];
  const pidQueue = [...(psPidOutputs ?? [makeOutput(gateRow())])];
  const audited = [];
  const psPidSpy = vi.fn(async () => (pidQueue.length > 1 ? pidQueue.shift() : pidQueue[0]));
  const killSpy = kill ?? vi.fn(async () => ({
    ok: true, signalsSent: ['SIGTERM', 'SIGKILL'], survivors: [], error: null, aborted: null,
  }));
  return {
    audited,
    killSpy,
    psPidSpy,
    deps: {
      runPs: vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0])),
      runPsPid: psPidSpy,
      readLedger: () => ({ records, malformedLines: 0, expired: 0 }),
      readOwnSessionId: async () => 'own-session',
      detectPeers: async () => peers,
      appendAudit: (_root, record) => { audited.push(record); },
      readAuditRecords: () => (auditRecords ?? audited),
      emitEvent: vi.fn(async () => true),
      killProcessGroup: killSpy,
      now: () => NOW,
      sleep: async () => {},
    },
  };
};

/**
 * A `killProcessGroup` stand-in that runs the REAL ladder from
 * `process-group.mjs` over an injected `killFn`. Tests that must prove
 * "no SIGKILL after a recycle" need the real gate wiring, not a spy that
 * ignores `beforeSignal`.
 */
const ladderKill = (state) => {
  const signals = [];
  const fn = vi.fn((pgid, opts) => realKillProcessGroup(pgid, {
    ...opts,
    killFn: (target, signal) => {
      signals.push({ target, signal });
      if (signal === 'SIGKILL' && !state.survivesSigkill) state.alive = false;
      return true;
    },
    isAliveFn: () => state.alive,
    sleepFn: async () => {},
  }));
  fn.signals = signals;
  return fn;
};

describe('runOrphanScan', () => {
  it('sends no signal in dryRun and books the candidate as dry-run in the audit — the module ships inert; Wave 3 arms the kill path', async () => {
    const { audited, killSpy, deps } = scanDeps({ psOutputs: [makeOutput(...REAL_ROWS, gateRow())] });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', deps });

    expect(res.candidates).toHaveLength(1);
    expect(res.killed).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
    expect(res.scanned).toBe(6);
    expect(res.malformed).toBe(0);
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      pid: 4242,
      pgid: 4242,
      trigger: 'orphan-ppid1',
      threshold: { minAgeSeconds: 300 },
      actual: { ageSeconds: ORPHAN_AGE_S },
      unit: 'seconds',
      command_signature: TSGO_SIG,
      decision: 'dry-run',
      args_head: TSGO_ARGS,
      session_id: 'own-session',
    });
  });

  it('does NOT signal when the PID was recycled between DETECTION and SIGTERM, and audits the withdrawal as reject — kill on a stale decision is the incident this guard exists for', async () => {
    // Bug (B3): the population snapshot is already old when the kill pass runs.
    // The targeted pre-SIGTERM probe shows a 3-second-old process on pid 4242
    // while the ledger says 432 s — a bystander, not our orphan.
    const recycled = gateRow({ etime: '00:03', args: 'tsgo --noEmit' });
    const state = { alive: true };
    const kill = ladderKill(state);
    const { audited, deps } = scanDeps({
      psOutputs: [makeOutput(gateRow())],
      psPidOutputs: [makeOutput(recycled)],
      kill,
    });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', dryRun: false, deps });

    expect(kill.signals).toEqual([]); // not one signal left the process
    expect(res.killed).toEqual([]);
    expect(res.rejected.some((r) => r.pid === 4242 && r.reason === 'identity-mismatch')).toBe(true);
    const rejects = audited.filter((r) => r.decision === 'reject');
    expect(rejects).toHaveLength(1);
    expect(rejects[0]).toMatchObject({ reason: 'identity-mismatch', result: { signalsSent: [] } });
  });

  it('does NOT escalate when the PID is recycled between SIGTERM and SIGKILL — the 10 s grace is itself a recycling window', async () => {
    // Bug (B3, the half a single pre-ladder check misses): the identity was
    // verified before SIGTERM, then the process died and the kernel handed 4242
    // to a stranger during the grace. A ladder that escalates unconditionally
    // SIGKILLs that stranger's whole process GROUP.
    const state = { alive: true };
    const kill = ladderKill(state);
    const recycled = gateRow({ etime: '00:02', args: 'tsgo --noEmit' });
    const { audited, deps } = scanDeps({
      psOutputs: [makeOutput(gateRow())],
      // 1st probe (pre-SIGTERM): still ours. 2nd (pre-SIGKILL): a stranger.
      psPidOutputs: [makeOutput(gateRow()), makeOutput(recycled)],
      kill,
    });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', dryRun: false, deps });

    expect(kill.signals.map((s) => s.signal)).toEqual(['SIGTERM']);
    expect(kill.signals.every((s) => s.target === -4242)).toBe(true);
    expect(res.killed).toEqual([]);
    const reject = audited.find((r) => r.decision === 'reject');
    // The SIGTERM that DID go out is recorded — hiding it would under-report
    // what the reaper did to the host.
    expect(reject).toMatchObject({ reason: 'identity-mismatch', result: { signalsSent: ['SIGTERM'] } });
  });

  it('kills the process GROUP and proves success by re-measuring after the wait, never by the sent signal', async () => {
    const state = { alive: true };
    const kill = ladderKill(state);
    const sleeps = [];
    const { audited, deps } = scanDeps({
      psOutputs: [makeOutput(gateRow())],
      // ours, ours, then GONE (empty ps output after the ladder)
      psPidOutputs: [makeOutput(gateRow()), makeOutput(gateRow()), ''],
      kill,
    });
    deps.sleep = async (ms) => { sleeps.push(ms); };

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', dryRun: false, deps });

    expect(kill.signals).toEqual([
      { target: -4242, signal: 'SIGTERM' },
      { target: -4242, signal: 'SIGKILL' },
    ]);
    expect(res.killed).toEqual([{
      pid: 4242,
      pgid: 4242,
      ok: true,
      signalsSent: ['SIGTERM', 'SIGKILL'],
      survivors: [],
      survivedSigkill: false,
      verified: 'gone',
      verifiedAfterMs: 500,
    }]);
    // The reaper's OWN wait before re-measuring (B6), on top of the ladder's.
    expect(sleeps).toContain(500);
    expect(audited.at(-1)).toMatchObject({
      decision: 'kill',
      result: { ok: true, survivors: [], survivedSigkill: false, verifiedAfterMs: 500 },
    });
  });

  it('books a process that OUTLIVED SIGKILL as survivedSigkill, never as a success — an exit code and a sent signal prove nothing (PRD B6)', async () => {
    // Bug: a descendant that setsid-ed out of the group survives the group
    // SIGKILL. `ok: true` there is a false green at the exact place the module
    // exists to prevent one.
    const state = { alive: true, survivesSigkill: true };
    const kill = ladderKill(state);
    const { audited, deps } = scanDeps({
      psOutputs: [makeOutput(gateRow())],
      psPidOutputs: [makeOutput(gateRow())], // still there at every probe
      kill,
    });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', dryRun: false, deps });

    expect(res.killed[0]).toMatchObject({
      ok: false, survivors: [4242], survivedSigkill: true, verified: 'alive',
    });
    expect(audited.at(-1).result).toMatchObject({ ok: false, survivedSigkill: true });
  });

  it('never books an UNMEASURABLE post-kill state as success — an absent measurement must not look like a dead process', async () => {
    const state = { alive: true };
    const kill = ladderKill(state);
    const { deps } = scanDeps({
      psOutputs: [makeOutput(gateRow())],
      psPidOutputs: [makeOutput(gateRow()), makeOutput(gateRow()), null], // probe failed
      kill,
    });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', dryRun: false, deps });

    expect(res.killed[0]).toMatchObject({ ok: false, verified: 'unmeasured', survivedSigkill: false });
  });

  it('writes a COMPLETE B5 audit record for a kill — one trigger, threshold, actual, unit, pid, pgid, signature, args_head, decision, result', async () => {
    // Bug: an audit missing the ist-value or the trigger cannot answer "why
    // exactly was this killed" afterwards, which is the only question it exists
    // to answer (B5, DevWatchdogs' KillReason).
    const state = { alive: true };
    const { audited, deps } = scanDeps({
      psOutputs: [makeOutput(gateRow())],
      psPidOutputs: [makeOutput(gateRow()), makeOutput(gateRow()), ''],
      kill: ladderKill(state),
    });

    await runOrphanScan({ repoRoot: '/synthetic/repo', dryRun: false, deps });

    const record = audited.at(-1);
    expect(Object.keys(record).sort()).toEqual([
      'actual', 'args_head', 'command_signature', 'decision', 'pgid', 'pid',
      'result', 'session_id', 'threshold', 'timestamp', 'trigger', 'unit',
    ]);
    expect(record).toMatchObject({
      pid: 4242,
      pgid: 4242,
      trigger: 'orphan-ppid1',
      threshold: { minAgeSeconds: 300 },
      actual: { ageSeconds: ORPHAN_AGE_S },
      unit: 'seconds',
      command_signature: TSGO_SIG,
      args_head: TSGO_ARGS,
      decision: 'kill',
      result: {
        ok: true, signalsSent: ['SIGTERM', 'SIGKILL'], survivors: [], survivedSigkill: false, verifiedAfterMs: 500,
      },
    });
    // Exactly ONE trigger per decision, by fixed priority — never a list.
    expect(Array.isArray(record.trigger)).toBe(false);
  });

  it('REPORTS a foreign live session and never calls killProcessGroup for it — melden, nie töten (PRD FA3)', async () => {
    // Bug: reaping another session's running gate process kills work in flight
    // in a session that has no idea this one exists.
    const state = { alive: true };
    const kill = ladderKill(state);
    const { audited, deps } = scanDeps({
      psOutputs: [makeOutput(gateRow())],
      records: [ledgerRecord({ sessionId: 'peer-session' })],
      peers: ['peer-session'],
      kill,
    });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', dryRun: false, deps });

    expect(kill).not.toHaveBeenCalled();
    expect(kill.signals).toEqual([]);
    expect(res.killed).toEqual([]);
    expect(res.candidates).toEqual([]);
    expect(res.reported[0]).toMatchObject({ pid: 4242, reason: 'foreign-live-session' });
    expect(audited[0]).toMatchObject({ decision: 'report', reason: 'foreign-live-session' });
  });

  it('degrades silently to skipped when ps fails, instead of throwing into its hook caller', async () => {
    const { deps } = scanDeps({ psOutputs: [null] });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', deps });

    expect(res.skipped).toBe('ps-failed');
    expect(res.candidates).toEqual([]);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    // A scan that measured nothing reports NOTHING about its own health either.
    expect(res.instrumentSuspect).toBeNull();
    expect(res.falseAlarmRate).toBeNull();
  });

  it('survives a throwing kill seam without rejecting the scan promise — a hook must never fail because a reap did', async () => {
    const kill = vi.fn(async () => { throw Object.assign(new Error('boom'), { code: 'EPERM' }); });
    const { deps } = scanDeps({ psOutputs: [makeOutput(gateRow())], kill });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', dryRun: false, deps });

    expect(res.killed[0]).toMatchObject({ ok: false, survivors: [4242], verified: 'unverified' });
  });
});

// ---------------------------------------------------------------------------
// Event + instrument health
// ---------------------------------------------------------------------------

describe('runOrphanScan — telemetry', () => {
  it('emits exactly ONE scan event when the scan found something', async () => {
    const { deps } = scanDeps({ psOutputs: [makeOutput(...REAL_ROWS, gateRow())] });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', deps });

    expect(deps.emitEvent).toHaveBeenCalledTimes(1);
    const [name, payload, opts] = deps.emitEvent.mock.calls[0];
    expect(name).toBe(REAPER_SCAN_EVENT);
    expect(payload).toMatchObject({
      scanned: 6,
      candidates: 1,
      reported: 0,
      killed: 0,
      survived_sigkill: 0,
      dry_run: true,
      instrument_suspect: false,
    });
    expect(typeof payload.duration_ms).toBe('number');
    // Below the 10-decision floor the rate is ABSENT, never 0 — a fabricated
    // zero would read as a clean instrument nobody measured.
    expect('false_alarm_rate' in payload).toBe(false);
    expect(opts).toEqual({ repoRoot: '/synthetic/repo' });
    expect(res.candidates).toHaveLength(1);
  });

  it('emits NOTHING on a scan that found nothing — a signal that fires on every hook is noise (HR-101)', async () => {
    const { deps } = scanDeps({ psOutputs: [makeOutput(...REAL_ROWS)], records: [] });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', deps });

    expect(res.candidates).toEqual([]);
    expect(res.rejected.length).toBeGreaterThan(0); // rejections alone do not emit
    expect(deps.emitEvent).not.toHaveBeenCalled();
  });

  it('flags instrumentSuspect at 6 false alarms in a 50-decision window and emits even on an otherwise empty scan', async () => {
    // HR-101: 6/50 = 12% > 10%. The instrument gets re-aimed, never
    // re-thresholded — so the flag is REPORTED and nothing acts on it.
    const auditRecords = [
      ...Array.from({ length: 6 }, () => ({ decision: 'reject' })),
      ...Array.from({ length: 44 }, () => ({ decision: 'kill', result: { ok: true } })),
    ];
    const { deps } = scanDeps({ psOutputs: [makeOutput(...REAL_ROWS)], records: [], auditRecords });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', deps });

    expect(res.falseAlarmRate).toBeCloseTo(0.12, 5);
    expect(res.falseAlarmRate).toBeGreaterThan(FALSE_ALARM_SUSPECT_RATE);
    expect(res.instrumentSuspect).toBe(true);
    expect(deps.emitEvent).toHaveBeenCalledTimes(1);
    expect(deps.emitEvent.mock.calls[0][1]).toMatchObject({
      instrument_suspect: true, false_alarm_rate: 0.12, candidates: 0,
    });
  });

  it('keeps a healthy instrument unflagged at 5 of 50 — the threshold is a ceiling, not a target', async () => {
    const auditRecords = [
      ...Array.from({ length: 5 }, () => ({ decision: 'reject' })),
      ...Array.from({ length: 45 }, () => ({ decision: 'kill', result: { ok: true } })),
    ];
    const { deps } = scanDeps({ psOutputs: [makeOutput(...REAL_ROWS)], records: [], auditRecords });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', deps });

    expect(res.falseAlarmRate).toBeCloseTo(0.1, 5);
    expect(res.instrumentSuspect).toBe(false);
    expect(deps.emitEvent).not.toHaveBeenCalled();
  });

  it('never lets a throwing emitter fail the scan — telemetry is not a precondition of a hook', async () => {
    const { deps } = scanDeps({ psOutputs: [makeOutput(gateRow())] });
    deps.emitEvent = vi.fn(async () => { throw new Error('ledger unwritable'); });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', deps });

    expect(res.candidates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Throttle, paths, HR-101 instrument health
// ---------------------------------------------------------------------------

describe('shouldScanNow', () => {
  it('skips a scan inside the min-interval and allows it once the interval has passed — without the throttle a PostToolBatch storm taxes every tool call with a ps', () => {
    const statFn = () => ({ mtimeMs: NOW - 10_000 });
    expect(shouldScanNow('/repo/.orchestrator/tmp/reaper-last-scan', NOW, 30, { statFn })).toBe(false);
    expect(shouldScanNow('/repo/.orchestrator/tmp/reaper-last-scan', NOW + 21_000, 30, { statFn })).toBe(true);
  });

  it('allows the very first scan when the marker does not exist — an absent throttle file must not disable the reaper', () => {
    const statFn = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    expect(shouldScanNow('/repo/.orchestrator/tmp/reaper-last-scan', NOW, 30, { statFn })).toBe(true);
  });

  it('writes the marker through the injected sink and builds both repo paths from one constant each', () => {
    const writes = [];
    expect(touchScanMarker('/repo/x', { writeFn: (p, data) => writes.push([p, data]) })).toBe(true);
    expect(writes[0][0]).toBe('/repo/x');
    expect(scanMarkerPath('/repo')).toBe('/repo/.orchestrator/tmp/reaper-last-scan');
    expect(auditPath('/repo')).toBe('/repo/.orchestrator/metrics/reaper-audit.jsonl');
  });
});

describe('falseAlarmRate', () => {
  it('returns null below 10 decisions instead of a rate computed from a handful — a missing measurement must not look like a measured zero (HR-105)', () => {
    const records = Array.from({ length: 9 }, () => ({ decision: 'dry-run' }));
    expect(falseAlarmRate(records)).toEqual({ rate: null, n: 9 });
    expect(falseAlarmRate([])).toEqual({ rate: null, n: 0 });
  });

  it('counts withdrawn candidates and unverified kills as false alarms over the firing population only — a report is the correct outcome, not a misfire (HR-101)', () => {
    const records = [
      ...Array.from({ length: 8 }, () => ({ decision: 'kill', result: { ok: true } })),
      { decision: 'reject' },
      { decision: 'kill', result: { ok: false } },
      ...Array.from({ length: 20 }, () => ({ decision: 'report' })),
    ];
    expect(falseAlarmRate(records)).toEqual({ rate: 0.2, n: 10 });
  });

  it('keeps only the last windowSize firings — a rolling window, not calendar time, so a quiet host still has a population', () => {
    const records = [
      ...Array.from({ length: 50 }, () => ({ decision: 'reject' })),
      ...Array.from({ length: 12 }, () => ({ decision: 'kill', result: { ok: true } })),
    ];
    expect(falseAlarmRate(records, 12)).toEqual({ rate: 0, n: 12 });
  });
});

describe('module contract', () => {
  it('pins the binding ps invocation Wave 3 and the fixtures both depend on', () => {
    expect([...PS_ARGS]).toEqual(['-Aww', '-o', 'pid=,ppid=,rss=,etime=,%cpu=,args=']);
  });

  it('pins the TARGETED ps invocation the pre-signal identity check depends on', () => {
    // Bug: dropping `-ww` re-enables column truncation, so a long command line
    // is cut and the signature check fails for a process that IS ours.
    expect(psPidArgs(4242)).toEqual(['-ww', '-p', '4242', '-o', 'pid=,ppid=,rss=,etime=,%cpu=,args=']);
  });

  it('resolveDeps supplies a real default for every seam and lets a test override each one', () => {
    const real = resolveDeps();
    for (const key of ['runPs', 'runPsPid', 'readLedger', 'verifyIdentity', 'killProcessGroup', 'detectPeers', 'readOwnSessionId', 'appendAudit', 'readAuditRecords', 'emitEvent', 'now', 'sleep']) {
      expect(typeof real[key]).toBe('function');
    }
    const stub = () => {};
    expect(resolveDeps({ killProcessGroup: stub }).killProcessGroup).toBe(stub);
    expect(resolveDeps({ runPsPid: stub }).runPsPid).toBe(stub);
    expect(resolveDeps({ emitEvent: stub }).emitEvent).toBe(stub);
  });
});

// ---------------------------------------------------------------------------
// CLI (the argv contract both trigger hooks build)
// ---------------------------------------------------------------------------

const REAPER_CLI = fileURLToPath(new URL('../../scripts/lib/orphan-reaper.mjs', import.meta.url));

describe('parseReaperCliArgs', () => {
  it('defaults to a REPORTING scan with the REAPER_DEFAULTS thresholds', () => {
    // Bug: a CLI that defaults to `kill` (or to `dryRun: false` by forgetting
    // the flag) turns a hand-run diagnosis into a signal-sending run — the
    // exact direction `runOrphanScan`'s own `dryRun = true` default refuses.
    const cli = parseReaperCliArgs([]);
    expect(cli.errors).toEqual([]);
    expect(cli.mode).toBe('report');
    expect(cli.dryRun).toBe(true);
    expect(cli.repoRoot).toBeNull();
    expect(cli.minAgeSeconds).toBe(REAPER_DEFAULTS.minAgeSeconds);
    expect(cli.killGraceMs).toBe(REAPER_DEFAULTS.killGraceMs);
    expect(cli.verifyWaitMs).toBe(REAPER_DEFAULTS.verifyWaitMs);
  });

  it('parses the exact argv both hooks build, and only --mode kill arms it', () => {
    // Bug: a flag renamed on one side of the hook/CLI seam produces a detached
    // child that exits 2 where nobody looks — the scan silently never runs.
    const cli = parseReaperCliArgs([
      '--repo-root', '/tmp/repo',
      '--mode', 'kill',
      '--min-age-seconds', '600',
      '--kill-grace-ms', '1000',
      '--verify-wait-ms', '250',
    ]);
    expect(cli.errors).toEqual([]);
    expect(cli).toMatchObject({
      repoRoot: '/tmp/repo',
      mode: 'kill',
      dryRun: false,
      minAgeSeconds: 600,
      killGraceMs: 1000,
      verifyWaitMs: 250,
    });
  });

  it('reports an error — and stays dry — for an unknown flag, a missing value, a bad number and a bad mode', () => {
    // Bug: tolerating junk argv means a mistyped flag runs with silently
    // different thresholds; a NaN threshold compares false against everything,
    // which is a disarmed gate wearing the shape of a configured one.
    expect(parseReaperCliArgs(['--repo-root', '/r', '--bogus']).errors)
      .toEqual(['unknown argument: --bogus']);
    expect(parseReaperCliArgs(['--repo-root']).errors).toEqual(['missing value for --repo-root']);
    expect(parseReaperCliArgs(['--min-age-seconds', 'soon']).errors)
      .toEqual(['--min-age-seconds expects a non-negative number, got "soon"']);

    const badMode = parseReaperCliArgs(['--mode', 'destroy']);
    expect(badMode.errors).toEqual(['--mode expects report|kill, got "destroy"']);
    expect(badMode.mode).toBe('report');
    expect(badMode.dryRun).toBe(true);
  });
});

describe('orphan-reaper CLI as a child process', () => {
  let ctmp;

  beforeEach(() => { ctmp = mkdtempSync(join(tmpdir(), 'reaper-cli-')); });
  afterEach(() => { rmSync(ctmp, { recursive: true, force: true }); });

  it('runs a report scan against a repo root and prints a JSON result (exit 0)', () => {
    // Bug: the entry guard silently not firing. `isMainModule` compares
    // realpaths precisely because a symlinked invocation path (macOS /tmp ->
    // /private/tmp is one) makes the naive comparison false — main() then never
    // runs, nothing prints, and the process exits 0, which every caller reads
    // as a completed scan. Asserting on the OUTPUT is what separates the two.
    const res = spawnSync(
      process.execPath,
      [REAPER_CLI, '--repo-root', ctmp, '--mode', 'report', '--json'],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(res.status).toBe(0);
    const result = JSON.parse(res.stdout);
    expect(result.repoRoot).toBe(ctmp);
    expect(result.mode).toBe('report');
    expect(typeof result.scanned).toBe('number');
    expect(result.scanned).toBeGreaterThan(0);
    // A report-mode run signals nothing, whatever it found.
    expect(result.killed).toEqual([]);
  });

  it('exits 2 on an unknown flag, writing the diagnosis to stderr', () => {
    const res = spawnSync(process.execPath, [REAPER_CLI, '--destroy-everything'], {
      encoding: 'utf8', timeout: 30_000,
    });
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('unknown argument: --destroy-everything');
  });
});
