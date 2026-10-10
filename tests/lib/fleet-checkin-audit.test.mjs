/**
 * N/write gate (#1462): production audit API consumed by the CLI. These cases
 * guard false zeroes, identity conflation and invented history; protocol/registry
 * tests validate individual records, never the population join (searched first).
 * Credible mutations: >= becomes > at 30:00, remove repo from join/collision,
 * discard invalid rows/duplicate IDs, or infer claims from heartbeat timestamps.
 * Fixtures call the real API; no new test-only seam or filesystem access.
 */
import { describe, expect, it } from 'vitest';
import { auditCheckins } from '../../scripts/lib/fleet-checkin-audit.mjs';

const AT = '2026-10-10T12:00:00Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const registryRow = (overrides = {}) => ({
  session_id: 'one', repo_path_hash: HASH_A,
  started_at: '2026-10-10T11:30:00Z', last_heartbeat: AT, ...overrides,
});
const checkinRow = (overrides = {}) => ({
  session: 'one', plattform: 'codex', repo: 'alpha', modus: 'deep',
  auftrag_ref: '#1462', kandidaten: [42], schreibbereich: [], rueckfall: 'stop',
  zeit: '2026-10-10T11:30:00Z', ...overrides,
});
const claim = (overrides = {}) => ({
  session: 'one', repo_key: 'a', candidate: '#42',
  from: '2026-10-10T11:30:00Z', to: AT, evidence_ref: 'snapshot:1', ...overrides,
});
function input(registryRecords = [], checkinRecords = [], claims = []) {
  return {
    at: AT, repos: ['a', 'b'],
    registry: {
      version: 1, captured_at: AT, complete: true, records: registryRecords,
      repo_bindings: [
        { repo_key: 'a', registry_hashes: [HASH_A], checkin_repos: ['alpha'] },
        { repo_key: 'b', registry_hashes: [HASH_B], checkin_repos: ['beta'] },
      ],
    },
    checkins: {
      version: 1, captured_at: AT, complete: true, records: checkinRecords, claims,
      coverage: { complete: true, from: '2026-10-10T11:00:00Z', to: AT },
    },
  };
}
const measured = (value) => ({ status: 'measured', value, reasons: [] });
function notMeasurable(metric) {
  expect(metric.status).toBe('not-measurable');
  expect(metric.value).toBeNull();
  expect(metric.reasons.length).toBeGreaterThan(0);
}

describe('auditCheckins — evidence-bound population join', () => {
  it('measures explicitly complete empty population without touching inputs', () => {
    const args = input();
    const before = JSON.stringify(args);
    const result = auditCheckins(args);
    expect(result.status).toBe('measured');
    expect(Object.values(result.metrics)).toEqual(Array(5).fill(measured(0)));
    expect(result.coverage).toEqual({ complete: true, from: '2026-10-10T11:00:00.000Z', to: '2026-10-10T12:00:00.000Z' });
    expect(JSON.stringify(args)).toBe(before);
  });

  it.each([
    ['missing registry', (v) => { v.registry = undefined; }, 'selected'],
    ['unreadable checkins', (v) => { v.checkins = null; }, 'missing_after_30m'],
    ['partial population', (v) => { v.registry.complete = false; }, 'selected'],
    ['different capture', (v) => { v.registry.captured_at = '2026-10-10T11:59:59Z'; }, 'selected'],
    ['missing records', (v) => { delete v.checkins.records; }, 'missing_after_30m'],
    ['unknown selected repo', (v) => { v.repos.push('unknown'); }, 'selected'],
  ])('refuses an invented zero for %s', (_name, alter, metric) => {
    const args = input(); alter(args);
    const result = auditCheckins(args);
    notMeasurable(result.metrics[metric]);
    for (const source of ['registry', 'checkins']) {
      if (!Array.isArray(args[source]?.records)) {
        expect(result.snapshots[source]).toEqual({ raw: null, valid: null, invalid: null, ambiguous: null, stale: null });
      }
    }
  });

  it('separates the 29:59 and inclusive 30:00 denominator', () => {
    const result = auditCheckins(input([
      registryRow(),
      registryRow({ session_id: 'young', started_at: '2026-10-10T11:30:01Z' }),
    ]));
    expect(result.metrics.selected).toEqual(measured(2));
    expect(result.metrics.fresh).toEqual(measured(2));
    expect(result.metrics.due).toEqual(measured(1));
    expect(result.metrics.missing_after_30m).toEqual(measured(1));
    expect(result.findings.missing_sessions).toEqual([{ repo_key: 'a', session: 'one' }]);
  });

  it('reports stale registry rows without counting them as due live sessions', () => {
    const result = auditCheckins(input([
      registryRow({ session_id: 'stale', last_heartbeat: '2026-10-10T11:44:59Z' }),
      registryRow({ session_id: 'boundary', last_heartbeat: '2026-10-10T11:45:00Z' }),
    ]));
    expect(result.snapshots.registry.stale).toBe(1);
    expect(result.metrics.selected).toEqual(measured(2));
    expect(result.metrics.fresh).toEqual(measured(1));
    expect(result.metrics.due).toEqual(measured(1));
  });

  it.each([
    null,
    registryRow({ last_heartbeat: '2026-10-10T12:00:01Z' }),
    registryRow({ started_at: 'invalid' }),
    registryRow({ started_at: '2026-02-30T11:30:00Z' }),
    registryRow({ started_at: '2026-10-10T12:00:01Z' }),
    registryRow({ repo_path_hash: 'c'.repeat(64) }),
  ])('does not discard damaged or unknown registry population %#', (damaged) => {
    const args = input([registryRow(), damaged]);
    args.repos = ['a'];
    const result = auditCheckins(args);
    expect(result.snapshots.registry.raw).toBe(2);
    expect(result.snapshots.registry.invalid).toBe(1);
    notMeasurable(result.metrics.selected);
    expect(result.issues.some((issue) => issue.source === 'registry' && issue.index === 1)).toBe(true);
  });

  it.each(['registry', 'checkins'])('does not silently deduplicate repeated %s sessions', (source) => {
    const args = input([registryRow()], [checkinRow()]);
    args[source].records.push({ ...args[source].records[0] });
    const result = auditCheckins(args);
    expect(result.snapshots[source].ambiguous).toBe(2);
    notMeasurable(result.metrics.missing_after_30m);
    expect(result.issues.filter((issue) => issue.code === 'duplicate-session')).toHaveLength(2);
  });

  it('refuses ambiguous bindings and preserves problems outside the selected repo', () => {
    const args = input([registryRow()], [checkinRow({ session: 'orphan', repo: 'beta' })]);
    args.repos = ['a'];
    const result = auditCheckins(args);
    expect(result.metrics.selected).toEqual(measured(1));
    notMeasurable(result.metrics.missing_after_30m);
    args.registry.repo_bindings[1].registry_hashes = [HASH_A];
    notMeasurable(auditCheckins(args).metrics.selected);
  });

  it.each([
    ['before registration', { zeit: '2026-10-10T11:29:59Z' }],
    ['future', { zeit: '2026-10-10T12:00:01Z' }],
    ['wrong raw session id', { session: 'one-semantic-label' }],
    ['wrong repo', { repo: 'beta' }],
    ['unknown repo', { repo: 'unknown' }],
    ['unsafe numeric candidate', { kandidaten: [Number.MAX_SAFE_INTEGER + 1] }],
    ['malformed timestamp', { zeit: '2026-02-30T12:00:00Z' }],
  ])('rejects check-in %s as positive evidence', (_name, overrides) => {
    const result = auditCheckins(input([registryRow()], [checkinRow(overrides)]));
    expect(result.metrics.selected).toEqual(measured(1));
    expect(result.snapshots.checkins.invalid).toBe(1);
    notMeasurable(result.metrics.missing_after_30m);
  });

  it('accepts check-ins at or after registration without an invented TTL', () => {
    for (const zeit of ['2026-10-10T11:30:00Z', '2026-10-10T11:59:59Z']) {
      const result = auditCheckins(input([registryRow()], [checkinRow({ zeit })]));
      expect(result.metrics.missing_after_30m).toEqual(measured(0));
    }
  });

  it('missing history blocks only collisions, never a measured point denominator', () => {
    const args = input([registryRow()], [checkinRow()]);
    delete args.checkins.claims;
    delete args.checkins.coverage;
    const result = auditCheckins(args);
    expect(result.metrics.due).toEqual(measured(1));
    expect(result.metrics.missing_after_30m).toEqual(measured(0));
    notMeasurable(result.metrics.collisions);
    expect(result.status).toBe('not-measurable');
  });
});

describe('auditCheckins — explicit candidate intervals', () => {
  function twoSessions(repo = 'a') {
    return input([
      registryRow(), registryRow({ session_id: 'two', repo_path_hash: repo === 'a' ? HASH_A : HASH_B }),
    ], [checkinRow(), checkinRow({ session: 'two', repo: repo === 'a' ? 'alpha' : 'beta', kandidaten: ['#42'] })], [
      claim(), claim({ session: 'two', repo_key: repo, candidate: 42, from: '2026-10-10T11:45:00Z' }),
    ]);
  }

  it('normalizes 42 and #42 and measures two distinct overlapping sessions in one repo', () => {
    const result = auditCheckins(twoSessions());
    expect(result.metrics.collisions).toEqual(measured(1));
    expect(result.findings.collisions).toEqual([{
      repo_key: 'a', candidate: '42', sessions: ['one', 'two'],
      from: '2026-10-10T11:45:00.000Z', to: '2026-10-10T12:00:00.000Z',
    }]);
  });

  it('same IID in different repositories is not a collision', () => {
    expect(auditCheckins(twoSessions('b')).metrics.collisions).toEqual(measured(0));
  });

  it('half-open adjacency and expired intervals do not invent current overlap', () => {
    const args = twoSessions();
    args.checkins.claims[0].to = '2026-10-10T11:45:00Z';
    args.checkins.claims[1].to = '2026-10-10T11:55:00Z';
    expect(auditCheckins(args).metrics.collisions).toEqual(measured(0));
  });

  it.each([
    ['before check-in', { from: '2026-10-10T11:29:59Z' }],
    ['future endpoint', { to: '2026-10-10T12:00:01Z' }],
    ['zero interval', { from: AT }],
    ['missing evidence', { evidence_ref: '' }],
    ['wrong session', { session: 'unknown' }],
    ['wrong candidate', { candidate: 43 }],
    ['wrong repository', { repo_key: 'b' }],
  ])('does not measure a claim %s', (_name, overrides) => {
    const args = twoSessions();
    Object.assign(args.checkins.claims[0], overrides);
    const result = auditCheckins(args);
    notMeasurable(result.metrics.collisions);
    expect(result.findings.collisions).toEqual([]);
    expect(result.metrics.missing_after_30m).toEqual(measured(0));
  });

  it('reports out-of-coverage evidence instead of clipping it', () => {
    const args = twoSessions();
    args.checkins.coverage.from = '2026-10-10T11:40:00Z';
    notMeasurable(auditCheckins(args).metrics.collisions);
    args.checkins.coverage.from = '2026-10-10T11:00:00Z';
    args.checkins.coverage.complete = false;
    notMeasurable(auditCheckins(args).metrics.collisions);
  });

  it('duplicate overlapping claims cannot multiply a collision', () => {
    const args = twoSessions();
    args.checkins.claims.push({ ...args.checkins.claims[0] });
    const result = auditCheckins(args);
    notMeasurable(result.metrics.collisions);
    expect(result.issues.some((issue) => issue.code === 'duplicate-overlapping-claims')).toBe(true);
  });
});
