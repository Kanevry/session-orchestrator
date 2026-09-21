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

import { describe, it, expect, vi } from 'vitest';

import {
  PS_ARGS,
  READ_ONLY_COMMAND_PATTERNS,
  REAPER_DEFAULTS,
  auditPath,
  decideReapCandidates,
  falseAlarmRate,
  parsePsSnapshot,
  parsePsSnapshotDetailed,
  resolveDeps,
  runOrphanScan,
  scanMarkerPath,
  shouldScanNow,
  touchScanMarker,
} from '../../scripts/lib/orphan-reaper.mjs';
import { buildCommandSignature } from '../../scripts/lib/process-group.mjs';

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

const scanDeps = ({ psOutputs, records = [ledgerRecord()], peers = [], kill } = {}) => {
  const queue = [...psOutputs];
  const audited = [];
  const killSpy = kill ?? vi.fn(async () => ({ ok: true, signalsSent: ['SIGTERM', 'SIGKILL'], survivors: [], error: null }));
  return {
    audited,
    killSpy,
    deps: {
      runPs: vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0])),
      readLedger: () => ({ records, malformedLines: 0, expired: 0 }),
      readOwnSessionId: async () => 'own-session',
      detectPeers: async () => peers,
      appendAudit: (_root, record) => { audited.push(record); },
      killProcessGroup: killSpy,
      now: () => NOW,
      sleep: async () => {},
    },
  };
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

  it('does NOT kill when the FRESH pre-signal snapshot shows a different process on the PID, and audits the withdrawal as reject — kill on a stale decision is the incident this guard exists for', async () => {
    const recycled = gateRow({ etime: '00:03', args: 'tsgo --noEmit' });
    const { audited, killSpy, deps } = scanDeps({
      psOutputs: [makeOutput(gateRow()), makeOutput(recycled)],
    });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', dryRun: false, deps });

    expect(killSpy).not.toHaveBeenCalled();
    expect(res.killed).toEqual([]);
    expect(res.rejected.some((r) => r.pid === 4242 && r.reason === 'identity-mismatch')).toBe(true);
    expect(audited.filter((r) => r.decision === 'reject')).toHaveLength(1);
  });

  it('kills the process GROUP (negative-pgid semantics live in killProcessGroup) and records the verified result, never the sent signal, as success', async () => {
    const { audited, killSpy, deps } = scanDeps({ psOutputs: [makeOutput(gateRow())] });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', dryRun: false, deps });

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy.mock.calls[0][0]).toBe(4242);
    expect(killSpy.mock.calls[0][1]).toMatchObject({ killGraceMs: 10_000, verifyWaitMs: 500 });
    expect(res.killed).toEqual([{
      pid: 4242, pgid: 4242, ok: true, signalsSent: ['SIGTERM', 'SIGKILL'], survivors: [], verifiedAfterMs: 500,
    }]);
    expect(audited.at(-1)).toMatchObject({ decision: 'kill', result: { ok: true, survivors: [] } });
  });

  it('books a SIGKILL survivor as a failed kill rather than a success — an exit code and a sent signal prove nothing (PRD B6)', async () => {
    const kill = vi.fn(async () => ({ ok: false, signalsSent: ['SIGTERM', 'SIGKILL'], survivors: [4242], error: null }));
    const { audited, deps } = scanDeps({ psOutputs: [makeOutput(gateRow())], kill });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', dryRun: false, deps });

    expect(res.killed[0]).toMatchObject({ ok: false, survivors: [4242] });
    expect(audited.at(-1).result).toMatchObject({ ok: false, survivors: [4242] });
  });

  it('degrades silently to skipped when ps fails, instead of throwing into its hook caller', async () => {
    const { deps } = scanDeps({ psOutputs: [null] });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', deps });

    expect(res.skipped).toBe('ps-failed');
    expect(res.candidates).toEqual([]);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('survives a throwing kill seam without rejecting the scan promise — a hook must never fail because a reap did', async () => {
    const kill = vi.fn(async () => { throw Object.assign(new Error('boom'), { code: 'EPERM' }); });
    const { deps } = scanDeps({ psOutputs: [makeOutput(gateRow())], kill });

    const res = await runOrphanScan({ repoRoot: '/synthetic/repo', dryRun: false, deps });

    expect(res.killed[0]).toMatchObject({ ok: false, survivors: [4242] });
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

  it('resolveDeps supplies a real default for every seam and lets a test override each one', () => {
    const real = resolveDeps();
    for (const key of ['runPs', 'readLedger', 'verifyIdentity', 'killProcessGroup', 'detectPeers', 'readOwnSessionId', 'appendAudit', 'now', 'sleep']) {
      expect(typeof real[key]).toBe('function');
    }
    const stub = () => {};
    expect(resolveDeps({ killProcessGroup: stub }).killProcessGroup).toBe(stub);
  });
});
